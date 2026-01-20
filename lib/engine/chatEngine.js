import {
  getCustomerById,
  getCustomerBySlug,
  getAiConfig,
  getAnalysisConfig,
  getActiveActions,
  getSession,
  createSession,
  updateSession,
  updateSessionMetadata,
  saveMessage
} from '../db/supabase.js';

import { callGemini, buildChatContents, buildSystemPrompt } from '../ai/gemini.js';
import { shouldRunAnalysis, analyzeConversation, getFiredTriggers } from '../ai/analysis.js';
import { checkKeywordTriggers, executeActionsForTrigger } from '../actions/executor.js';
import { pushNewGuestMessage } from '../notifications/push.js';

// ============================================
// MAIN CHAT ENGINE
// ============================================
export async function handleChat({ prompt, history, sessionId, customerId, slug, isTestMode }) {
  
  // ============================================
  // STEP 1: Identify customer
  // ============================================
  let customer = null;
  
  if (customerId) {
    customer = await getCustomerById(customerId);
  } else if (slug) {
    customer = await getCustomerBySlug(slug);
  }

  if (!customer) {
    return { error: 'Customer not found', status: 404 };
  }

  console.log(`🏢 Customer identified: ${customer.name} (${customer.id})`);

  // ============================================
  // STEP 2: Load all configs in parallel
  // ============================================
  const [aiConfig, analysisConfig, actions] = await Promise.all([
    getAiConfig(customer.id),
    getAnalysisConfig(customer.id),
    getActiveActions(customer.id)
  ]);

  if (!aiConfig) {
    console.error('No AI config found for customer:', customer.id);
    return { error: 'AI configuration not found', status: 500 };
  }

  console.log(`🤖 AI loaded: ${aiConfig.ai_name} (${aiConfig.ai_role})`);
  console.log(`📋 Loaded ${actions.length} actions`);

  // ============================================
  // STEP 3: Get or create session
  // ============================================
  let currentSessionId = sessionId;
  let existingSession = null;

  if (currentSessionId) {
    existingSession = await getSession(currentSessionId);
  }

  if (!currentSessionId) {
    const newSession = await createSession(customer.id, {
      source: 'eryai-engine',
      is_test: isTestMode
    });

    if (newSession) {
      currentSessionId = newSession.id;
      existingSession = newSession;
      console.log(`📝 New session created: ${currentSessionId}`);
    }
  }

  // ============================================
  // STEP 4: Check if human took over
  // ============================================
  let humanTookOver = false;

  // Check from history
  if (history && Array.isArray(history)) {
    const recentHistory = history.slice(-3);
    humanTookOver = recentHistory.some(msg => msg.sender_type === 'human');
  }

  // Check session flag
  if (existingSession?.needs_human) {
    humanTookOver = true;
  }

  if (humanTookOver) {
    console.log('👤 Human took over - AI will not respond');
  }

  // ============================================
  // STEP 5: Save user message
  // ============================================
  if (currentSessionId) {
    await saveMessage(currentSessionId, 'user', prompt, 'user');
    await updateSession(currentSessionId, {});
  }

  // ============================================
  // STEP 6: If human took over, send push and return
  // ============================================
  if (humanTookOver && currentSessionId) {
    const guestName = existingSession?.metadata?.guest_name || 'Gäst';

    // Send push notification for new guest message
    await pushNewGuestMessage(customer.id, currentSessionId, guestName, prompt);

    return {
      response: '',
      sessionId: currentSessionId,
      humanTookOver: true
    };
  }

  // ============================================
  // STEP 7: Check keyword triggers
  // ============================================
  const triggeredActions = checkKeywordTriggers(prompt, actions);

  // ============================================
  // STEP 8: Build system prompt and call AI
  // ============================================
  const systemPrompt = buildSystemPrompt(aiConfig, triggeredActions);
  const contents = buildChatContents(systemPrompt, aiConfig.greeting, history, prompt);

  let aiResponse = '';

  try {
    aiResponse = await callGemini(contents, {
      temperature: aiConfig.temperature || 0.7,
      maxOutputTokens: aiConfig.max_tokens || 500
    });
  } catch (err) {
    console.error('Gemini error:', err);
    return { error: 'AI service error', status: 500 };
  }

  // ============================================
  // STEP 9: Save AI response
  // ============================================
  if (currentSessionId && aiResponse) {
    await saveMessage(currentSessionId, 'assistant', aiResponse, 'ai');
    await updateSession(currentSessionId, {});
  }

  // ============================================
  // STEP 10: Run analysis (awaited to ensure it completes)
  // ============================================
  if (currentSessionId && analysisConfig) {
    const fullConversation = [
      ...(history || []),
      { role: 'user', content: prompt },
      { role: 'assistant', content: aiResponse }
    ];

    // Await analysis to ensure it runs before function ends
    await runAnalysis(
      currentSessionId,
      customer,
      aiConfig,
      analysisConfig,
      actions,
      fullConversation,
      aiResponse,
      isTestMode
    );
  }

  // ============================================
  // STEP 11: Return response
  // ============================================
  return {
    response: aiResponse,
    sessionId: currentSessionId,
    customerId: customer.id,
    customerName: customer.name,
    aiName: aiConfig.ai_name,
    triggeredActions: triggeredActions.map(a => a.action_type),
    needsHandoff: false
  };
}

// ============================================
// ANALYSIS (runs after AI response)
// ============================================
async function runAnalysis(sessionId, customer, aiConfig, analysisConfig, actions, conversation, aiResponse, isTestMode) {
  console.log('🔄 Starting analysis...');
  
  try {
    // Check if we should run analysis
    const { shouldRun, triggers } = shouldRunAnalysis(conversation, aiResponse, analysisConfig);

    if (!shouldRun) {
      console.log('ℹ️ No analysis triggers detected');
      return;
    }

    console.log('🔍 Analysis triggers:', triggers);

    // Run Gemini analysis
    console.log('🧠 Calling Gemini for analysis...');
    const analysis = await analyzeConversation(conversation, aiConfig.ai_name);

    if (!analysis) {
      console.log('⚠️ Analysis returned null');
      return;
    }

    console.log('📊 Conversation analysis:', analysis);

    // Update session with guest info
    if (analysis.guest_name || analysis.guest_email || analysis.guest_phone) {
      await updateSessionMetadata(sessionId, {
        guest_name: analysis.guest_name,
        guest_email: analysis.guest_email,
        guest_phone: analysis.guest_phone
      });
      console.log('✅ Session updated with guest info:', analysis.guest_name);
    }

    // Get fired triggers and execute actions
    const firedTriggers = getFiredTriggers(analysis);
    console.log('🎯 Fired triggers:', firedTriggers);

    if (firedTriggers.length === 0) {
      console.log('ℹ️ No triggers fired');
      return;
    }

    const context = {
      sessionId,
      customer,
      aiConfig,
      analysisConfig,
      analysis,
      isTestMode
    };

    for (const trigger of firedTriggers) {
      console.log(`⚙️ Executing actions for trigger: ${trigger}`);
      await executeActionsForTrigger(trigger, actions, context);
    }

    console.log('✅ Analysis complete');

  } catch (err) {
    console.error('❌ Analysis error:', err.message);
    console.error(err.stack);
  }
}
